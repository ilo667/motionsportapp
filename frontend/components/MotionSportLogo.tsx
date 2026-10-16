import Image from "next/image";
import Link from "next/link";

export function MotionSportLogo({ white = false, className = "w-[133px] sm:w-[184px]" }: { white?: boolean; className?: string }) {
  return (
    <Link href="/">
      <Image
        src={white ? "/motionsport-logo-white.png" : "/motionsport-logo.png"}
        alt="MotionSport"
        width={184}
        height={34}
        quality={100}
        priority
        className={className}
      />
    </Link>
  );
}