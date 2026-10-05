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
            guard CFGetTypeID(raw) == AXUIElementGetTypeID() else { return .failure(.wrongType(name)) }
            // The type ID check above is what makes this cast hold.
            return .success(raw as! AXUIElement)
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
            guard CFGetTypeID(raw) == AXValueGetTypeID() else { return .failure(.wrongType(name)) }
            // The type ID check above is what makes this cast hold.
            return .success(raw as! AXValue)
        }
    }
}
