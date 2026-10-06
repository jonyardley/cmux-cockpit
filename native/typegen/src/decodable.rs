//! A facet_generate plugin that writes an `init(from:)` into each Swift
//! type, reading serde_json's default shapes: a struct is an object keyed
//! by the Rust field names, a unit variant a bare string, and any other
//! variant a one-key object, `{"Name": payload}`. Every field is required
//! except an `Option`, so a key missing from the JSON fails loudly.

use std::io;

use facet_generate::generation::CodeGeneratorConfig;
use facet_generate::generation::indent::IndentWrite;
use facet_generate::generation::plugin::{EmitContext, EmitterPlugin};
use facet_generate::generation::swift::Swift;
use facet_generate::reflection::format::{ContainerFormat, Format, Named, VariantFormat};
use heck::ToLowerCamelCase as _;

/// The plugin; see the module docs.
#[derive(Debug)]
pub struct DecodablePlugin;

/// Written once, before the types: a coding key for any name, and short
/// getters so each generated line stays readable.
const HELPERS: &str = r#"public struct SerdeKey: CodingKey {
    public var stringValue: String
    public var intValue: Int? { nil }
    public init(_ s: String) { stringValue = s }
    public init?(stringValue: String) { self.stringValue = stringValue }
    public init?(intValue: Int) { nil }
}

extension KeyedDecodingContainer where K == SerdeKey {
    func req<T: Decodable>(_ k: String) throws -> T { try decode(T.self, forKey: SerdeKey(k)) }
    func opt<T: Decodable>(_ k: String) throws -> T? { try decodeIfPresent(T.self, forKey: SerdeKey(k)) }
}

extension UnkeyedDecodingContainer {
    mutating func next<T: Decodable>() throws -> T { try decode(T.self) }
}

func unknownVariant(_ type: String, _ name: String, _ decoder: Decoder) -> Error {
    DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "unknown \(type) variant \(name)"))
}"#;

/// The Swift name the emitter gives a field or variant: the same heck
/// rule, so `.wsId` here is `wsId` there.
fn swift_name(rust: &str) -> String {
    rust.to_lower_camel_case()
}

/// `opt` for an `Option`, which may be absent or null; `req` otherwise.
fn getter(f: &Format) -> &'static str {
    if matches!(f, Format::Option(_)) {
        "opt"
    } else {
        "req"
    }
}

/// `wsId: try n.req("ws_id")`, from container `from`.
fn field_arg(f: &Named<Format>, from: &str) -> String {
    format!(
        "{}: try {from}.{}(\"{}\")",
        swift_name(&f.name),
        getter(&f.value),
        f.name
    )
}

fn write_struct(w: &mut dyn IndentWrite, fields: &[Named<Format>]) -> io::Result<()> {
    if !fields.is_empty() {
        writeln!(
            w,
            "    let c = try decoder.container(keyedBy: SerdeKey.self)"
        )?;
    }
    for f in fields {
        writeln!(
            w,
            "    self.{} = try c.{}(\"{}\")",
            swift_name(&f.name),
            getter(&f.value),
            f.name
        )?;
    }
    Ok(())
}

/// Unit variants arrive as a bare string.
fn write_units(w: &mut dyn IndentWrite, name: &str, units: &[&str]) -> io::Result<()> {
    if units.is_empty() {
        return Ok(());
    }
    writeln!(
        w,
        "    if let s = try? decoder.singleValueContainer().decode(String.self) {{"
    )?;
    writeln!(w, "        switch s {{")?;
    for v in units {
        writeln!(w, "        case \"{v}\": self = .{}", swift_name(v))?;
    }
    writeln!(
        w,
        "        default: throw unknownVariant(\"{name}\", s, decoder)"
    )?;
    writeln!(w, "        }}")?;
    writeln!(w, "        return")?;
    writeln!(w, "    }}")
}

/// One case of the one-key object's switch, for a variant with a payload.
fn write_payload_case(w: &mut dyn IndentWrite, v: &Named<VariantFormat>) -> io::Result<()> {
    let (json, case) = (&v.name, swift_name(&v.name));
    match &v.value {
        VariantFormat::NewType(f) => writeln!(
            w,
            "    case \"{json}\": self = .{case}(try c.{}(\"{json}\"))",
            getter(f)
        ),
        VariantFormat::Tuple(fs) => {
            writeln!(w, "    case \"{json}\":")?;
            writeln!(
                w,
                "        var u = try c.nestedUnkeyedContainer(forKey: key)"
            )?;
            let args: Vec<&str> = fs.iter().map(|_| "try u.next()").collect();
            writeln!(w, "        self = .{case}({})", args.join(", "))
        }
        VariantFormat::Struct(fields) => {
            writeln!(w, "    case \"{json}\":")?;
            writeln!(
                w,
                "        let n = try c.nestedContainer(keyedBy: SerdeKey.self, forKey: key)"
            )?;
            let args: Vec<String> = fields.iter().map(|f| field_arg(f, "n")).collect();
            writeln!(w, "        self = .{case}({})", args.join(", "))
        }
        VariantFormat::Unit | VariantFormat::Variable(_) => Ok(()),
    }
}

fn write_enum<'a>(
    w: &mut dyn IndentWrite,
    name: &str,
    variants: impl Iterator<Item = &'a Named<VariantFormat>>,
) -> io::Result<()> {
    let (units, payloads): (Vec<_>, Vec<_>) =
        variants.partition(|v| matches!(v.value, VariantFormat::Unit));
    let unit_names: Vec<&str> = units.iter().map(|v| v.name.as_str()).collect();
    write_units(w, name, &unit_names)?;
    if payloads.is_empty() {
        // Only unit variants: anything but a known string is an error.
        return writeln!(
            w,
            "    throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: \"{name}: expected a string\"))"
        );
    }
    writeln!(
        w,
        "    let c = try decoder.container(keyedBy: SerdeKey.self)"
    )?;
    writeln!(
        w,
        "    guard let key = c.allKeys.first, c.allKeys.count == 1 else {{"
    )?;
    writeln!(
        w,
        "        throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: \"{name}: expected one variant key\"))"
    )?;
    writeln!(w, "    }}")?;
    writeln!(w, "    switch key.stringValue {{")?;
    for v in payloads {
        write_payload_case(w, v)?;
    }
    writeln!(
        w,
        "    default: throw unknownVariant(\"{name}\", key.stringValue, decoder)"
    )?;
    writeln!(w, "    }}")
}

impl EmitterPlugin<Swift> for DecodablePlugin {
    fn imports(&self, _: &CodeGeneratorConfig) -> Vec<String> {
        vec!["Foundation".into()]
    }

    fn module_helpers(&self, w: &mut dyn IndentWrite, _: &CodeGeneratorConfig) -> io::Result<()> {
        writeln!(w)?;
        writeln!(w, "{HELPERS}")
    }

    fn has_type_body(&self, _: &EmitContext) -> bool {
        true
    }

    fn type_body(&self, w: &mut dyn IndentWrite, ctx: &EmitContext) -> io::Result<()> {
        writeln!(w)?;
        writeln!(w, "public init(from decoder: Decoder) throws {{")?;
        match ctx.container.format {
            ContainerFormat::Enum(variants, _, _) => write_enum(w, ctx.name(), variants.values())?,
            _ => write_struct(w, &ctx.fields())?,
        }
        writeln!(w, "}}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swift_names_follow_the_emitter() {
        assert_eq!(swift_name("ws_id"), "wsId");
        assert_eq!(swift_name("NewProject"), "newProject");
        assert_eq!(swift_name("clayText"), "clayText");
        assert_eq!(swift_name("bg"), "bg");
    }

    #[test]
    fn only_an_option_is_optional() {
        assert_eq!(getter(&Format::Option(Box::new(Format::Str))), "opt");
        assert_eq!(getter(&Format::Str), "req");
        assert_eq!(getter(&Format::Seq(Box::new(Format::Str))), "req");
    }
}
