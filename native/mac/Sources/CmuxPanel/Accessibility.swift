import ApplicationServices
import PanelLayout

/// Why an Accessibility read failed. Every read returns one of these
/// rather than trapping: cmux can quit or close a window between calls.
enum AXFailure: Error, Equatable {
    case attribute(String, AXError)
    case wrongType(String)
}

/// Thin, failure-modelled reads of Accessibility attributes.
enum AX {
    static func value(_ element: AXUIElement, _ name: String) -> Result<CFTypeRef, AXFailure> {
        var raw: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, name as CFString, &raw)
        guard error == .success, let raw else { return .failure(.attribute(name, error)) }
        return .success(raw)
    }

    static func bool(_ element: AXUIElement, _ name: String) -> Result<Bool, AXFailure> {
        value(element, name).flatMap { raw in
            guard let flag = raw as? Bool else { return .failure(.wrongType(name)) }
            return .success(flag)
        }
    }

    static func string(_ element: AXUIElement, _ name: String) -> Result<String, AXFailure> {
        value(element, name).flatMap { raw in
            guard let text = raw as? String else { return .failure(.wrongType(name)) }
            return .success(text)
        }
    }

    static func element(_ element: AXUIElement, _ name: String) -> Result<AXUIElement, AXFailure> {
        value(element, name).flatMap { raw in
            guard let found: AXUIElement = cfCast(raw, typeID: AXUIElementGetTypeID()) else {
                return .failure(.wrongType(name))
            }
            return .success(found)
        }
    }

    static func elements(_ element: AXUIElement, _ name: String) -> Result<[AXUIElement], AXFailure> {
        value(element, name).flatMap { raw in
            guard let list = raw as? [AXUIElement] else { return .failure(.wrongType(name)) }
            return .success(list)
        }
    }

    /// A window's frame, top-left and y down, from its position and size.
    static func frame(_ window: AXUIElement) -> Result<Rect, AXFailure> {
        axValue(window, kAXPositionAttribute).flatMap { position in
            axValue(window, kAXSizeAttribute).flatMap { size in
                var origin = CGPoint.zero
                var extent = CGSize.zero
                guard AXValueGetValue(position, .cgPoint, &origin), AXValueGetValue(size, .cgSize, &extent) else {
                    return .failure(.wrongType(kAXPositionAttribute))
                }
                return .success(Rect(x: origin.x, y: origin.y, width: extent.width, height: extent.height))
            }
        }
    }

    private static func axValue(_ element: AXUIElement, _ name: String) -> Result<AXValue, AXFailure> {
        value(element, name).flatMap { raw in
            guard let found: AXValue = cfCast(raw, typeID: AXValueGetTypeID()) else {
                return .failure(.wrongType(name))
            }
            return .success(found)
        }
    }
}

/// A Core Foundation value as the type its type ID says, or nil. A cast to
/// a Core Foundation type does not check the type itself (it always
/// succeeds), so the type ID guard is the real check. The cast is generic
/// only so the compiler accepts `as?` in place of a force cast.
private func cfCast<T>(_ raw: CFTypeRef, typeID: CFTypeID) -> T? {
    guard CFGetTypeID(raw) == typeID else { return nil }
    return raw as? T
}
