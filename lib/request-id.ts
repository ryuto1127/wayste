export function generateRequestId(): string {
  return crypto.randomUUID().slice(0, 8);
}
