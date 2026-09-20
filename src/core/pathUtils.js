export function joinPath(...parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && part !== '')
    .join('/')
    .replace(/\/+/g, '/');
}
