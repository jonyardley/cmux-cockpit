//! Writes the panel model's Swift types to native/mac/Generated/, where
//! the Xcode project and native/mac/test.sh compile them. The folder is
//! gitignored: the Swift is rebuilt from the Rust on every build. The file
//! is left alone when nothing changed, so Xcode does not recompile it.

use std::path::Path;
use std::process::ExitCode;

fn main() -> ExitCode {
    match write() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("cockpit_typegen: {e}");
            ExitCode::FAILURE
        }
    }
}

fn write() -> Result<(), cockpit_typegen::Error> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../mac/Generated");
    let path = dir.join("PanelTypes.swift");
    let swift = cockpit_typegen::swift()?;
    if std::fs::read_to_string(&path).ok().as_deref() != Some(swift.as_str()) {
        std::fs::create_dir_all(&dir)?;
        std::fs::write(&path, swift)?;
    }
    Ok(())
}
