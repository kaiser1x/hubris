export interface AuditEntry {
  event: string;
  ref: string;
  at: string;
}

const TRAIL: AuditEntry[] = [];

export function auditLog(event: string, ref: string): AuditEntry {
  const entry: AuditEntry = { event, ref, at: new Date().toISOString() };
  TRAIL.push(entry);
  return entry;
}

export function auditTrail(): AuditEntry[] {
  return TRAIL;
}
