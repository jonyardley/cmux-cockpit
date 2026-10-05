//! The pane's colours: each core token mapped to the hex the sidebar draws
//! it with (src/cockpit/theme.ts, src/shared/palette.ts). The palette is
//! built for the sidebar's light ground, so the pane paints that ground
//! under everything and reads the same in a dark terminal. A faint token
//! (a hue at an alpha) is blended onto the ground, since a terminal cell
//! has no alpha. Every colour literal in the pane lives here.

use cockpit_core::theme::Token;
use ratatui::style::{Color, Modifier, Style};

/// The sidebars' ground, under the whole pane.
pub const GROUND: u32 = 0xF4F2EA;
/// The ink of titles.
pub const TEXT: u32 = 0x141413;
/// The Needs you strip's face.
pub const NEEDS_BG: u32 = 0xFBECE4;
/// The face of the card under the cursor: the link hover, a chip-strength step.
pub const CURSOR_BG: u32 = 0xECEAE3;
/// The second ink: a card's detail and a lane's heading.
pub const SECONDARY: u32 = 0x5E5D59;
/// The third ink: where you left off.
pub const TERTIARY: u32 = 0x73726C;
/// The outline of a dot with no colour of its own.
pub const GREY: u32 = 0xA09E95;
/// The unread badge's words, on the second ink.
pub const ON_BADGE: u32 = 0xFFFFFF;

const CLAY: u32 = 0xD97757;
const BLUE: u32 = 0x3B6FB6;
const AMBER: u32 = 0xD9A03F;
const GREEN: u32 = 0x788C5D;
const CLAY_TEXT: u32 = 0xA34A2A;
const AMBER_TEXT: u32 = 0x8A5A0B;
const INK_HEADING: u32 = 0x3D3D3A;
const RED: u32 = 0xC0453A;
const GREEN_DEEP: u32 = 0x3F5A2B;

/// `rgb` at `alpha` (0 to 255) laid over `under`, per channel, rounded.
pub fn blend(rgb: u32, alpha: u8, under: u32) -> u32 {
    let a = u32::from(alpha);
    let mix = |shift: u32| {
        let top = (rgb >> shift) & 0xFF;
        let bottom = (under >> shift) & 0xFF;
        ((top * a + bottom * (255 - a) + 127) / 255) << shift
    };
    mix(16) | mix(8) | mix(0)
}

/// A hex as a terminal colour.
pub fn rgb(hex: u32) -> Color {
    let [_, r, g, b] = hex.to_be_bytes();
    Color::Rgb(r, g, b)
}

/// A token's hex, faint ones already blended onto the ground.
pub fn hex(t: Token) -> u32 {
    match t {
        Token::Clear => GROUND,
        Token::Blue => BLUE,
        Token::Clay => CLAY,
        Token::Green => GREEN,
        Token::Amber => AMBER,
        Token::BlueHalo => blend(BLUE, 0x2E, GROUND),
        Token::ClayHalo => blend(CLAY, 0x38, GROUND),
        Token::AmberHalo => blend(AMBER, 0x38, GROUND),
        Token::BlueText => 0x2F5690,
        Token::ClayText => CLAY_TEXT,
        Token::GreenText => 0x5E7A40,
        Token::AmberText => AMBER_TEXT,
        Token::MetaText => 0x6B6A64,
        Token::Faint | Token::LaneBackground => 0x8A8880,
        Token::Heading | Token::Select | Token::LaneMain => INK_HEADING,
        Token::GreenDeep => GREEN_DEEP,
        Token::Text => TEXT,
        Token::Secondary => SECONDARY,
        Token::RedText => 0x9E2F27,
        Token::ChipFace => 0xF1EFE8,
        Token::ChipEdge => 0xE2DFD3,
        Token::RedChipFace => blend(RED, 0x1A, GROUND),
        Token::RedChipEdge => blend(RED, 0x38, GROUND),
        Token::BlueChipFace => blend(BLUE, 0x1A, GROUND),
        Token::BlueChipEdge => blend(BLUE, 0x38, GROUND),
        Token::GreenChipFace => blend(GREEN, 0x29, GROUND),
        Token::GreenChipEdge => blend(GREEN_DEEP, 0x59, GROUND),
        Token::CountBg => 0xE5E2D6,
        Token::BlueCount => blend(BLUE, 0x1F, GROUND),
        Token::ClayCount => blend(CLAY, 0x29, GROUND),
        Token::AmberCount => blend(AMBER, 0x29, GROUND),
        Token::AmberRowEdge => blend(AMBER_TEXT, 0x29, GROUND),
        Token::NeedsRowEdge => blend(CLAY_TEXT, 0x29, GROUND),
        Token::CardEdge => blend(TEXT, 0x1F, GROUND),
        Token::LaneReview => 0x5E5D59,
        Token::LaneParked => 0xB0AEA5,
        Token::LaneUnsorted => 0xC9C6BB,
    }
}

/// A project's own colour, "#D97757" as the table writes it; None for
/// anything but six hex digits after a "#".
pub fn parse_hex(s: &str) -> Option<u32> {
    let digits = s.strip_prefix('#')?;
    if digits.len() != 6 || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    u32::from_str_radix(digits, 16).ok()
}

/// A token as a terminal colour.
pub fn colour(t: Token) -> Color {
    rgb(hex(t))
}

/// The pane's base: ink on the ground.
pub fn base() -> Style {
    Style::new().fg(rgb(TEXT)).bg(rgb(GROUND))
}

/// Words in a token's colour.
pub fn ink(t: Token) -> Style {
    Style::new().fg(colour(t))
}

/// Words in a token's colour, bold.
pub fn strong(t: Token) -> Style {
    ink(t).add_modifier(Modifier::BOLD)
}

/// Title ink.
pub fn title() -> Style {
    Style::new().fg(rgb(TEXT))
}

/// Words in one of the pane's own inks.
pub fn plain(hex: u32) -> Style {
    Style::new().fg(rgb(hex))
}

/// A dot's ink: its token, or the grey outline with none.
pub fn icon(ink: Option<Token>) -> Style {
    match ink {
        Some(t) => self::ink(t),
        None => plain(GREY),
    }
}

/// The unread badge: white on the second ink.
pub fn badge() -> Style {
    Style::new()
        .fg(rgb(ON_BADGE))
        .bg(rgb(SECONDARY))
        .add_modifier(Modifier::BOLD)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blends_a_faint_hue_onto_the_ground() {
        assert_eq!(blend(0x000000, 0, GROUND), GROUND);
        assert_eq!(blend(0x123456, 255, GROUND), 0x123456);
        // Half of black over white is mid grey.
        assert_eq!(blend(0x000000, 0x80, 0xFFFFFF), 0x7F7F7F);
    }

    #[test]
    fn maps_hex_to_red_green_and_blue() {
        assert_eq!(rgb(0xD97757), Color::Rgb(0xD9, 0x77, 0x57));
    }

    #[test]
    fn outlines_a_dot_with_no_colour_in_grey() {
        assert_eq!(icon(None).fg, Some(rgb(GREY)));
        assert_eq!(icon(Some(Token::Blue)).fg, Some(colour(Token::Blue)));
    }

    #[test]
    fn reads_a_projects_colour_and_refuses_anything_else() {
        assert_eq!(parse_hex("#D97757"), Some(0xD97757));
        assert_eq!(parse_hex("#d97757"), Some(0xD97757));
        assert_eq!(parse_hex("D97757"), None);
        assert_eq!(parse_hex("#D9775"), None);
        assert_eq!(parse_hex("#D9775G"), None);
        assert_eq!(parse_hex("#+97757"), None);
    }

    #[test]
    fn draws_clear_as_the_ground() {
        assert_eq!(colour(Token::Clear), rgb(GROUND));
    }

    #[test]
    fn keeps_each_state_hue_apart() {
        let hues = [Token::Blue, Token::Clay, Token::Green, Token::Amber];
        for (i, a) in hues.iter().enumerate() {
            for b in &hues[i + 1..] {
                assert_ne!(hex(*a), hex(*b));
            }
        }
    }
}
