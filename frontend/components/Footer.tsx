import { MotionGymLogo } from "./MotionGymLogo";

export function Footer() {
  return (
    <footer className="bg-navy pt-6 pb-4 px-5 sm:py-10 sm:px-16 mt-auto rounded-tl-[16px] rounded-tr-[16px] sm:rounded-tl-[24px] sm:rounded-tr-[24px]">
      <MotionGymLogo className="h-11 w-auto sm:h-13" />
      <p className="text-white text-xs leading-[16px] sm:text-base sm:leading-[22px] mt-10 sm:mt-[23px]">All rights reserved 2026</p>
    </footer>
  );
}