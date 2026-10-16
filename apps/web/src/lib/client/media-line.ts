/** A line that is nothing but a studio link: shown as the picture, not the address. */
export const isMediaLine = (line: string): { kind: 'image' | 'video'; url: string } | undefined => {
  const match = /^\s*(https?:\/\/\S+\/api\/media\/[A-Za-z0-9_-]+\?t=[A-Za-z0-9_-]+&k=(image|video))\s*$/.exec(line);
  return match === null ? undefined : { kind: match[2] as 'image' | 'video', url: match[1] as string };
};
