/** Assemble des classes CSS en ignorant les valeurs vides. */
export const cn = (...parts: (string | false | null | undefined | 0)[]): string => parts.filter(Boolean).join(' ');
