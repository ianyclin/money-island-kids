import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "小小理財島",
    short_name: "理財島",
    description: "給家庭一起使用的兒童零用錢與夢想管理 App。",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f4f0e7",
    theme_color: "#f4f0e7",
    lang: "zh-Hant",
    orientation: "any",
  };
}
