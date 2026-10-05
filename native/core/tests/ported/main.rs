//! The TypeScript cases that exercise model.ts, status.ts, strip.ts,
//! lane-entries.ts, next.ts, drop.ts and the shared helpers they read, one Rust test
//! per case, named after it. A module per TypeScript test file, a module
//! inside per `describe`. Cases that test another module (the Projects
//! rows, chips, the agents sidebar, views) are left for the lanes
//! that port those; the pull request lists each one.

#![cfg(test)]

mod support;

mod asking_saved;
mod card;
mod cockpit;
mod count_tint_saved;
mod drop;
mod halo;
mod helpers_saved;
mod left_off_quiet;
mod merge_ready;
mod merged;
mod move_saved;
mod needs;
mod next;
mod reveal;
mod shells_saved;
mod state_seed;
mod ui_seed;
