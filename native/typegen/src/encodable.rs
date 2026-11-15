//! A facet_generate plugin that writes an `encode(to:)` into the Swift
//! types the shell sends to the core: the core's `Event` and every type it
//! reaches. It writes serde_json's default shapes, the ones
//! `DecodablePlugin` reads: a struct is an object keyed by the Rust field
//! names, a unit variant a bare string, and a newtype or struct variant a
//! one-key object, `{"Name": payload}`. An `Option` writes `null` when
//! empty, never leaves its key out, as serde does. Any other shape (a
//! tuple struct or tuple variant) fails the generator, as it does there.
//! The panel's other types get nothing: the Swift side only reads them.

use std::collections::BTreeSet;
use std::io;

use facet_generate::generation::CodeGeneratorConfig;
use facet_generate::generation::indent::IndentWrite;
use facet_generate::generation::plugin::{EmitContext, EmitterPlugin};
use facet_generate::generation::swift::Swift;
use facet_generate::reflection::format::{ContainerFormat, Format, Named, VariantFormat};
use heck::ToLowerCamelCase as _;

/// The plugin; see the module docs. `sent` holds the Swift names of the
/// types that get an encoder.
#[derive(Debug)]
pub struct EncodablePlugin {
    pub sent: BTreeSet<String>,
}

/// Written once, before the types, beside `DecodablePlugin`'s helpers,
/// whose `SerdeKey` it uses.
const HELPERS: &str = r#"extension KeyedEncodingContainer where K == SerdeKey {
    mutating func put<T: Encodable>(_ v: T, _ k: String) throws { try encode(v, forKey: SerdeKey(k)) }
}

func encodeUnit(_ encoder: Encoder, _ name: String) throws {
    var c = encoder.singleValueContainer()
    try c.encode(name)
}"#;

/// The Swift name the emitter gives a field or variant.
fn swift_name(rust: &str) -> String {
    rust.to_lower_camel_case()
}

fn unsupported(what: &str) -> io::Error {
    io::Error::other(format!("cannot write {what} in serde_json's shapes yet"))
}

fn write_struct(w: &mut dyn IndentWrite, fields: &[Named<Format>]) -> io::Result<()> {
    if fields.is_empty() {
        // serde writes a unit struct as null.
        writeln!(w, "    var c = encoder.singleValueContainer()")?;
        return writeln!(w, "    try c.encodeNil()");
    }
    writeln!(w, "    var c = encoder.container(keyedBy: SerdeKey.self)")?;
    for f in fields {
        writeln!(
            w,
            "    try c.put(self.{}, \"{}\")",
            swift_name(&f.name),
            f.name
        )?;
    }
    Ok(())
}

/// One case of the switch over `self`. Payloads bind as `f0`, `f1` and
/// so on, so no field name can shadow `encoder` or the containers.
fn write_case(w: &mut dyn IndentWrite, v: &Named<VariantFormat>) -> io::Result<()> {
    let (json, case) = (&v.name, swift_name(&v.name));
    match &v.value {
        VariantFormat::Unit => writeln!(w, "    case .{case}: try encodeUnit(encoder, \"{json}\")"),
        VariantFormat::NewType(_) => {
            writeln!(w, "    case let .{case}(f0):")?;
            writeln!(
                w,
                "        var c = encoder.container(keyedBy: SerdeKey.self)"
            )?;
            writeln!(w, "        try c.put(f0, \"{json}\")")
        }
        VariantFormat::Struct(fields) => {
            let binds: Vec<String> = (0..fields.len()).map(|i| format!("f{i}")).collect();
            writeln!(w, "    case let .{case}({}):", binds.join(", "))?;
            writeln!(
                w,
                "        var c = encoder.container(keyedBy: SerdeKey.self)"
            )?;
            writeln!(
                w,
                "        var n = c.nestedContainer(keyedBy: SerdeKey.self, forKey: SerdeKey(\"{json}\"))"
            )?;
            for (f, b) in fields.iter().zip(&binds) {
                writeln!(w, "        try n.put({b}, \"{}\")", f.name)?;
            }
            Ok(())
        }
        VariantFormat::Tuple(_) | VariantFormat::Variable(_) => Err(unsupported(&format!(
            "variant {json}: only unit, newtype and struct variants are written"
        ))),
    }
}

impl EmitterPlugin<Swift> for EncodablePlugin {
    fn imports(&self, _: &CodeGeneratorConfig) -> Vec<String> {
        vec!["Foundation".into()]
    }

    fn module_helpers(&self, w: &mut dyn IndentWrite, _: &CodeGeneratorConfig) -> io::Result<()> {
        writeln!(w)?;
        writeln!(w, "{HELPERS}")
    }

    fn has_type_body(&self, ctx: &EmitContext) -> bool {
        self.sent.contains(ctx.name())
    }

    fn type_body(&self, w: &mut dyn IndentWrite, ctx: &EmitContext) -> io::Result<()> {
        if !self.sent.contains(ctx.name()) {
            return Ok(());
        }
        writeln!(w)?;
        writeln!(w, "public func encode(to encoder: Encoder) throws {{")?;
        match ctx.container.format {
            ContainerFormat::Enum(variants, _, _) => {
                writeln!(w, "    switch self {{")?;
                for v in variants.values() {
                    write_case(w, v)?;
                }
                writeln!(w, "    }}")?;
            }
            ContainerFormat::Struct(..) | ContainerFormat::UnitStruct(_) => {
                write_struct(w, &ctx.fields())?;
            }
            ContainerFormat::NewTypeStruct(..) | ContainerFormat::TupleStruct(..) => {
                return Err(unsupported(&format!("{}, a tuple struct", ctx.name())));
            }
        }
        writeln!(w, "}}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swift_names_follow_the_emitter() {
        assert_eq!(swift_name("MoveCard"), "moveCard");
        assert_eq!(swift_name("ws_id"), "wsId");
    }
}
