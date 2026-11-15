// Older backends do not report capabilities; retain their existing behavior.
export function guestCapability(status, name) {
  const capabilities = status?.guest_capabilities;
  if (typeof capabilities?.available?.[name] === "boolean")
    return capabilities.available[name];
  return !capabilities?.unavailable?.includes(name);
}
