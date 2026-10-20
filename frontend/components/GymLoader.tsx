export function GymLoader() {
  return (
    <div className="gym-loader">
      <div className="gym-loader__circle">
        <div className="gym-loader__outer"></div>
        <div className="gym-loader__inner"></div>
        <div className="gym-loader__center"></div>
      </div>
      <span className="gym-loader__text">LOADING</span>
    </div>
  );
}