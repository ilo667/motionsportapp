import { MotionSportLogo } from "./MotionSportLogo";

export function Footer() {
  return (
    <footer className="bg-navy pt-[24px] pb-[16px] px-[19px] sm:py-[40px] sm:px-[70px] mt-auto rounded-tl-[16px] rounded-tr-[16px] sm:rounded-tl-[24px] sm:rounded-tr-[24px]">
      <MotionSportLogo white className="w-[162px] sm:w-[184px]" />
      <p className="text-white text-[12px] leading-[16px] sm:text-[16px] sm:leading-[22px] mt-[40px] sm:mt-[23px]">All rights reserved 2026</p>
    </footer>
  );
}