import Image from "next/image";
import Link from "next/link";
/** GitHub brand mark. Inlined because lucide-react no longer ships brand icons. */
function GithubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-1.98c-3.2.7-3.88-1.54-3.88-1.54-.53-1.34-1.3-1.7-1.3-1.7-1.05-.72.08-.71.08-.71 1.17.08 1.78 1.2 1.78 1.2 1.04 1.78 2.73 1.27 3.4.97.1-.75.4-1.27.73-1.56-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .96-.3 3.15 1.18a10.9 10.9 0 0 1 5.74 0c2.18-1.48 3.14-1.18 3.14-1.18.63 1.59.23 2.76.12 3.05.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.4-5.25 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.2.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z" />
    </svg>
  );
}

/** X (formerly Twitter) brand mark. */
function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M18.9 1.15h3.68l-8.04 9.19L24 22.85h-7.41l-5.8-7.584-6.64 7.584H.47l8.32-9.51L0 1.15h7.6l5.44 7.19 5.86-7.19Zm-1.29 19.5h2.04L6.48 3.24H4.29l13.32 17.41Z" />
    </svg>
  );
}

/** A single navigable entry in a footer column. */
interface FooterLink {
  /** Visible link text. */
  label: string;
  /** Destination — an internal route, in-page anchor, or absolute URL. */
  href: string;
  /** Whether the link points outside the app and needs a new tab. */
  external?: boolean;
}

/** A titled group of related footer links. */
interface FooterColumn {
  title: string;
  links: FooterLink[];
}

const FOOTER_COLUMNS: FooterColumn[] = [
  {
    title: "Product",
    links: [
      { label: "Features", href: "/#features" },
      { label: "Documentation", href: "/docs" },
      { label: "Mission Control", href: "/dashboard" },
    ],
  },
  {
    title: "Community",
    links: [
      {
        label: "GitHub",
        href: "https://github.com/GauravKarakoti/SecureFlow",
        external: true,
      },
      {
        label: "Twitter / X",
        href: "https://x.com/GauravKara_Koti",
        external: true,
      },
      { label: "Leaderboard", href: "/leaderboard" },
    ],
  },
  {
    title: "Legal & Trust",
    links: [
      { label: "Privacy Policy", href: "/privacy" },
      { label: "Terms of Service", href: "/terms" },
      { label: "Security Policies", href: "/security" },
    ],
  },
];

const SOCIAL_LINKS = [
  {
    label: "GitHub",
    href: "https://github.com/GauravKarakoti/SecureFlow",
    Icon: GithubIcon,
  },
  {
    label: "Twitter / X",
    href: "https://x.com/GauravKara_Koti",
    Icon: XIcon,
  },
] as const;

/**
 * Landing page footer.
 *
 * Renders the SecureFlow brand block alongside grouped navigation columns and
 * social icon links. Stacks into a single column on small viewports and
 * expands to a multi-column grid from the `md` breakpoint upward. The
 * copyright year is derived from the current date at render time.
 */
export function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="mt-auto border-t border-white/5 bg-background px-6 py-12">
      <div className="mx-auto max-w-6xl">
        <div className="grid grid-cols-1 gap-10 md:grid-cols-2 lg:grid-cols-4">
          {/* Brand */}
          <div className="lg:col-span-1">
            <Link href="/" className="flex items-center gap-2">
              <span className="glow-primary flex h-6 w-6 items-center justify-center rounded bg-primary">
                <Image
                  src="/logo.png"
                  alt="SecureFlow logo"
                  width={64}
                  height={64}
                  className="object-contain"
                />
              </span>
              <span className="font-headline text-lg font-bold tracking-tight">SecureFlow</span>
            </Link>

            <p className="mt-4 max-w-xs text-sm italic text-muted-foreground">
              &ldquo;The vault is empty. Zero traces left behind.&rdquo;
            </p>

            <div className="mt-5 flex items-center gap-3">
              {SOCIAL_LINKS.map(({ label, href, Icon }) => (
                <Link
                  key={label}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={label}
                  className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </Link>
              ))}
            </div>
          </div>

          {/* Navigation columns */}
          {FOOTER_COLUMNS.map((column) => (
            <nav key={column.title} aria-labelledby={`footer-${column.title}`}>
              <h2
                id={`footer-${column.title}`}
                className="font-headline text-sm font-semibold tracking-wide text-foreground"
              >
                {column.title}
              </h2>
              <ul className="mt-4 space-y-3">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      {...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                      className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-12 border-t border-white/5 pt-6 text-center text-sm text-muted-foreground">
          © {currentYear} SecureFlow Inc. All rights reserved.
        </div>
      </div>
    </footer>
  );
}
