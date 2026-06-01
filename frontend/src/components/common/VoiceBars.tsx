/** Small animated waveform bars that pulse with a 0..1 audio level. */
export function VoiceBars({ level, className = '' }: { level: number; className?: string }) {
  const mults = [0.5, 1, 0.72, 0.92, 0.6];
  return (
    <div className={`flex items-center gap-[2px] h-3.5 ${className}`}>
      {mults.map((m, i) => {
        const h = Math.max(15, Math.min(100, level * 320 * m));
        return (
          <span
            key={i}
            className="w-[3px] rounded-full bg-secondary transition-[height] duration-75 ease-out"
            style={{ height: `${h}%` }}
          />
        );
      })}
    </div>
  );
}
