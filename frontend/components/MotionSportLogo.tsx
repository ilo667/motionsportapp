import Image from "next/image";
import Link from "next/link";

export function MotionSportLogo({ className = "h-[40px] w-auto sm:h-[48px]" }: { white?: boolean; className?: string }) {
  return (
    <Link href="/">
      <Image
        src="/motion-sport-logo.jpg"
        alt="Motion Sport"
        width={150}
        height={150}
        quality={100}
        priority
        className={`rounded-lg ${className}`}
      />
    </Link>
  );
}