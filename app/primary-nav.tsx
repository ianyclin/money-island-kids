import Link from "next/link";

type PrimaryPage = "home" | "dreams" | "history" | "parent";

const primaryLinks: Array<{ id: PrimaryPage; href: string; label: string }> = [
  { id: "home", href: "/", label: "孩子首頁" },
  { id: "dreams", href: "/dreams", label: "夢想與回顧" },
  { id: "history", href: "/history", label: "所有紀錄" },
  { id: "parent", href: "/parent", label: "家長區" },
];

export function PrimaryNav({ active }: { active?: PrimaryPage }) {
  return (
    <nav className="primary-nav" aria-label="主要頁面">
      {primaryLinks.map((item) => (
        <Link
          className={item.id === active ? "is-active" : undefined}
          href={item.href}
          aria-current={item.id === active ? "page" : undefined}
          key={item.id}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
