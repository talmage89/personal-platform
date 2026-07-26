import { stanzaForDate } from "~/app/poem.ts";
import { Root } from "~/app/root.tsx";

/**
 * The only page an anonymous visitor can reach. Zero queries, zero JavaScript,
 * one link. Everything else on the internet that arrives here gets exactly this.
 */
export function Landing({ stanza }: { stanza: readonly string[] }) {
  return (
    <Root>
      <main class="flex grow flex-col items-center justify-center gap-10 text-center">
        <p class="text-balance leading-loose">
          {stanza.map((line, i) => (
            <>
              {i > 0 && <br />}
              {line}
            </>
          ))}
        </p>

        {/*
          The single link. Unlabelled by design, but not to a screen reader —
          crypticism is a visual choice and is not a reason to make the door
          impossible to find for someone using assistive technology.
        */}
        <a
          href="/auth/github"
          aria-label="Enter"
          class="text-2xl no-underline opacity-40 transition-opacity hover:opacity-100"
        >
          ↩
        </a>
      </main>
    </Root>
  );
}

export const renderLanding = (now: Date = new Date()) => <Landing stanza={stanzaForDate(now)} />;
