interface CircuitLinesProps {
  className?: string;
  animated?: boolean;
  opacity?: number;
}

export default function CircuitLines({
  className = "",
  animated = true,
  opacity = 0.12,
}: CircuitLinesProps) {
  return (
    <svg
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 h-full w-full ${className}`}
      style={{ opacity }}
      viewBox="0 0 800 600"
      preserveAspectRatio="xMidYMid slice"
      fill="none"
    >
      <defs>
        <linearGradient id="circuit-fade" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#E8E020" stopOpacity="0.6" />
          <stop offset="100%" stopColor="#E8E020" stopOpacity="0" />
        </linearGradient>
      </defs>

      {[
        "M0,80 H220 L260,40 H460 L500,80 H800",
        "M0,200 H120 L160,160 H380 L420,200 H640 L680,160 H800",
        "M0,340 H300 L340,380 H540 L580,340 H800",
        "M0,460 H180 L220,500 H420 L460,460 H700 L740,500 H800",
        "M100,0 V120 L140,160",
        "M700,0 V100 L660,140",
        "M0,560 H260 L300,520",
        "M520,600 V480 L560,440",
      ].map((d, i) => (
        <path
          key={i}
          d={d}
          stroke="url(#circuit-fade)"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          {animated && (
            <animate
              attributeName="stroke-opacity"
              values="0.2;0.8;0.2"
              dur={`${4 + (i % 3)}s`}
              begin={`${i * 0.4}s`}
              repeatCount="indefinite"
            />
          )}
        </path>
      ))}

      {[
        [220, 80], [460, 80], [380, 200], [420, 200],
        [300, 340], [540, 340], [220, 460], [420, 460],
      ].map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r="3" fill="#E8E020" fillOpacity="0.5" />
      ))}
    </svg>
  );
}
