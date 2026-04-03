export const assertServerOnly = (moduleName: string): void => {
  if (typeof window !== "undefined") {
    throw new Error(`${moduleName} is server-only and cannot be imported in client code.`);
  }
};
