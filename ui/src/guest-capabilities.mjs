// Older backends do not report capabilities; retain their existing behavior.
export function guestCapability(status, name) {
  const capabilities = status?.guest_capabilities;
  if (typeof capabilities?.available?.[name] === "boolean")
    return capabilities.available[name];
  // The remote Windows adapter implements a subset of the VM workbench.
  // Only explicitly reported features may start their requests or polling.
  if (status?.guest_system === "windows-remote") return false;
  return !capabilities?.unavailable?.includes(name);
}
