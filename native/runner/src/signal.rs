//! The bare "changed" signal cockpit-publish sends after each new
//! data.json or inbox/ answer: a distributed notification with no object
//! and no payload, as the R2 spike proved reaches the sandboxed sidebar
//! (its observer is `DistributedNotificationCenter.default()` under this
//! name). The sidebar reads the file on each one, and on a slow poll
//! besides, so a dropped signal only delays a frame.
//!
//! Posting needs CoreFoundation, which std does not wrap, so this is the
//! one foreign call in the runner: four C functions, each used as its
//! header documents. Elsewhere than macOS (the Linux CI) there is no
//! centre to post to, and `post` says so.

/// The notification's name, which the sidebar observes.
pub const CHANGED: &str = "dev.jonyardley.cockpit.changed";

/// Posts `name` to the distributed notification centre, delivered at
/// once. False when it could not be posted (no centre, or a name
/// CoreFoundation would not take).
#[cfg(target_os = "macos")]
pub fn post(name: &str) -> bool {
    mac::post(name)
}

/// No distributed notifications off macOS.
#[cfg(not(target_os = "macos"))]
pub fn post(_name: &str) -> bool {
    false
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;

    type CFTypeRef = *const c_void;
    type CFIndex = isize;
    type CFStringEncoding = u32;
    type Boolean = u8;

    const UTF8: CFStringEncoding = 0x0800_0100;

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFNotificationCenterGetDistributedCenter() -> CFTypeRef;
        fn CFStringCreateWithBytes(
            alloc: CFTypeRef,
            bytes: *const u8,
            len: CFIndex,
            encoding: CFStringEncoding,
            is_external: Boolean,
        ) -> CFTypeRef;
        fn CFNotificationCenterPostNotification(
            center: CFTypeRef,
            name: CFTypeRef,
            object: CFTypeRef,
            user_info: CFTypeRef,
            deliver_immediately: Boolean,
        );
        fn CFRelease(cf: CFTypeRef);
    }

    pub fn post(name: &str) -> bool {
        let Ok(len) = CFIndex::try_from(name.len()) else {
            return false;
        };
        // SAFETY: the distributed centre is a process-wide singleton,
        // never null on macOS and never released by its caller (the Get
        // rule). `bytes` and `len` describe `name`'s own UTF-8, which
        // CoreFoundation copies (is_external is false), so it need not
        // outlive the call; a null allocator is the default one. The
        // string is ours (the Create rule) and is released exactly once,
        // after the post, which retains what it keeps. A null object and
        // user info post a bare notification, as the sandbox requires.
        unsafe {
            let center = CFNotificationCenterGetDistributedCenter();
            if center.is_null() {
                return false;
            }
            let cf_name = CFStringCreateWithBytes(std::ptr::null(), name.as_ptr(), len, UTF8, 0);
            if cf_name.is_null() {
                return false;
            }
            CFNotificationCenterPostNotification(
                center,
                cf_name,
                std::ptr::null(),
                std::ptr::null(),
                1,
            );
            CFRelease(cf_name);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posts_on_macos_and_says_it_cannot_elsewhere() {
        // Nobody need listen: a post with no observer is no error.
        assert_eq!(post(CHANGED), cfg!(target_os = "macos"));
    }
}
