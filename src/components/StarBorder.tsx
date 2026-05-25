import React from 'react';

type StarBorderProps<T extends React.ElementType> = React.ComponentPropsWithoutRef<T> & {
  as?: T;
  className?: string;
  children?: React.ReactNode;
  color?: string;
  speed?: React.CSSProperties['animationDuration'];
  thickness?: number;
};

const StarBorder = <T extends React.ElementType = 'button'>({
  as,
  className = '',
  color = 'Magenta',
  speed = '5s',
  thickness = 1,
  children,
  style,
  ...rest
}: StarBorderProps<T>) => {
  const Component = as || 'button';

  return (
    <Component
      className={`star-border ${className}`.trim()}
      {...(rest as React.ComponentPropsWithoutRef<T>)}
      style={{
        '--star-border-color': color,
        '--star-border-speed': speed,
        '--star-border-thickness': `${thickness}px`,
        padding: `${thickness}px`,
        ...style
      } as React.CSSProperties}
    >
      <div className="star-border__beam star-border__beam--bottom" />
      <div className="star-border__beam star-border__beam--top" />
      <div className="star-border__content">{children}</div>
    </Component>
  );
};

export default StarBorder;
