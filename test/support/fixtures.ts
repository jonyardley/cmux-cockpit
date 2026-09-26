// Builders for fixture data: only the fields a test cares about.

let next = 0;

export function agent(status: AgentStatus, extra: Partial<Agent> = {}): Agent {
  next++;
  return { id: "a" + next, status, ...extra };
}

export function ws(id: string, extra: Partial<Workspace> = {}): Workspace {
  return { id, title: id, ...extra };
}

export function group(id: string, name: string, extra: Partial<WorkspaceGroup> = {}): WorkspaceGroup {
  return { id, name, ...extra };
}
