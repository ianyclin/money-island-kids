import Image from "next/image";

type ProfileAvatarProps = {
  avatar: string;
  name?: string;
};

export function ProfileAvatar({ avatar, name }: ProfileAvatarProps) {
  const isPhoto = avatar.startsWith("/api/profile-photo") || avatar.startsWith("https://") || avatar.startsWith("data:image/");
  if (!isPhoto) return <>{avatar}</>;
  return <Image className="profile-avatar-image" src={avatar} alt={name ? `${name}的照片` : ""} width={96} height={96} sizes="96px" unoptimized />;
}
