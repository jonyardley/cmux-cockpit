// Diagnostic 3: data-derived `let` is dead on this build. Test inline forms.
VStack(alignment: .leading, spacing: 3) {
    Text("P \(workspaces.filter { $0.unread > 0 }.count)").font(.system(size: 11))
    Text("S agents \(workspaces.filter { $0.agents != nil }.count)").font(.system(size: 11))
    if workspaces.filter { $0.unread == 0 }.count > 0 {
        Text("R if-trailing ok").font(.system(size: 11))
    }
    ForEach(workspaces.filter { $0.unread == 0 }) { w in
        Text("Q \(w.title)").font(.system(size: 11)).lineLimit(1)
    }
    ForEach(workspaces) { w in
        Text("T \(w.agents != nil ? "has" : "none") \(w.branch != nil ? w.branch : "nobranch")").font(.system(size: 11)).lineLimit(1)
    }
    Spacer()
}
