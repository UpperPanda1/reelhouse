// Mavonyx stub; the lookup (./mx-api.js) loads on first use. IMPLEMENTATION section 6.
export const id = 'mavonyx';
export const name = 'Mavonyx';
export const direct = true;
export const group = 'public';
export const note = 'Online source: refused in some countries';
let api;
export const search = async (m, c) => (await (api ||= import('./mx-api.js'))).search(m, c);
