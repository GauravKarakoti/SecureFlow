import React from 'react';
// Minimal next/image stub for vitest/jsdom — renders a plain <img>.
const Image = ({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { src: string; alt: string }) => (
  // eslint-disable-next-line @next/next/no-img-element
  <img src={src} alt={alt} {...props} />
);
export default Image;
