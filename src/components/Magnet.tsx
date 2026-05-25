import React, { useEffect, useRef } from 'react';

interface MagnetProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  padding?: number;
  disabled?: boolean;
  magnetStrength?: number;
  activeTransition?: string;
  inactiveTransition?: string;
  wrapperClassName?: string;
  innerClassName?: string;
}

const Magnet: React.FC<MagnetProps> = ({
  children,
  padding = 100,
  disabled = false,
  magnetStrength = 2,
  activeTransition = 'transform 0.3s ease-out',
  inactiveTransition = 'transform 0.5s ease-in-out',
  wrapperClassName = '',
  innerClassName = '',
  style,
  className,
  ...props
}) => {
  const magnetRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const activeRef = useRef(false);
  const lastPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  useEffect(() => {
    if (disabled) {
      activeRef.current = false;
      lastPosRef.current = { x: 0, y: 0 };
      if (innerRef.current) {
        innerRef.current.style.transition = inactiveTransition;
        innerRef.current.style.transform = 'translate3d(0px, 0px, 0)';
      }
      return;
    }

    const handleMouseMove = (e: MouseEvent) => {
      const el = magnetRef.current;
      const inner = innerRef.current;
      if (!el) return;
      if (!inner) return;

      const strength = Math.max(0.1, magnetStrength);
      const { left, top, width, height } = el.getBoundingClientRect();
      const centerX = left + width / 2;
      const centerY = top + height / 2;

      const distX = Math.abs(centerX - e.clientX);
      const distY = Math.abs(centerY - e.clientY);

      const isInside = distX < width / 2 + padding && distY < height / 2 + padding;
      const offsetX = isInside ? (e.clientX - centerX) / strength : 0;
      const offsetY = isInside ? (e.clientY - centerY) / strength : 0;

      if (activeRef.current !== isInside) {
        activeRef.current = isInside;
        inner.style.transition = isInside ? activeTransition : inactiveTransition;
      }

      lastPosRef.current = { x: offsetX, y: offsetY };

      if (rafRef.current !== null) return;
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null;
        const { x, y } = lastPosRef.current;
        inner.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
      });
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [activeTransition, disabled, inactiveTransition, magnetStrength, padding]);

  return (
    <div
      ref={magnetRef}
      className={[wrapperClassName, className].filter(Boolean).join(' ')}
      style={{ position: 'relative', display: 'inline-block', ...style }}
      {...props}
    >
      <div
        ref={innerRef}
        className={innerClassName}
        style={{
          transform: 'translate3d(0px, 0px, 0)',
          transition: inactiveTransition,
          willChange: 'transform'
        }}
      >
        {children}
      </div>
    </div>
  );
};

export default Magnet;
