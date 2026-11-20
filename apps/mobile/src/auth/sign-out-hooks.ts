type Hook = () => Promise<void>;
const hooks: Hook[] = [];

/** Work to do while still signed in, just before signing out (e.g. forget this device's push token). */
export function beforeSignOut(hook: Hook): void {
  hooks.push(hook);
}

export async function runBeforeSignOut(): Promise<void> {
  await Promise.allSettled(hooks.map((hook) => hook()));
}
