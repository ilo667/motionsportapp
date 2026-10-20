export function GymLoader({ className = "flex-1 flex flex-col items-center pt-10 space-y-7" }: { className?: string }) {
  return (
    <div className={className}>
      <div className="gym-loader__circle">
        <div className="gym-loader__outer"></div>
        <div className="gym-loader__inner"></div>
        <div className="gym-loader__center"></div>
      </div>
      <span className="gym-loader__text">ЗАЧЕКАЙТЕ</span>
    </div>
  );
}