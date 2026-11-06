import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Chip } from "@/components/cockpit/parts";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { AgentProfile } from "@/lib/agents/queries";
import { defaultAgentProfile } from "@/lib/agents/default-agent";

/**
 * The usage guide, in French like the person it is for. Same content as the published web guide,
 * kept to what is true of this deployment: every phrase leans on a tool the Duet bot really has
 * (add_tasks, mission_update, suggest_replies, intake_report, gmail_search_messages,
 * gmail_read_message, gmail_create_draft, calendar_list_events).
 */

export type PhraseFilter = "mail" | "missions" | "jour";

export type Phrase = {
  filter: PhraseFilter;
  say: string;
  does: string;
  /** Whether the tool behind it changes something (always as a draft or proposal you confirm). */
  changes: boolean;
};

export const PHRASES: readonly Phrase[] = [
  {
    filter: "mail",
    say: "Analyse mes mails des 3 derniers jours, ignore les newsletters, et ajoute en tâches ce qui demande une action de ma part.",
    does: "Cherche dans Gmail, lit les mails utiles, crée des cartes Up next avec le lien du mail.",
    changes: true,
  },
  {
    filter: "mail",
    say: "Qu'est-ce qui attend une réponse de moi depuis plus de 2 jours ?",
    does: "Liste les fils où tu es le dernier destinataire, sans rien modifier.",
    changes: false,
  },
  {
    filter: "mail",
    say: "Prépare un brouillon de réponse à ce mail, ton pro, court, et propose deux créneaux cette semaine.",
    does: "Lit ton agenda, écrit un brouillon dans Gmail. Rien n'est envoyé.",
    changes: true,
  },
  {
    filter: "mail",
    say: "Propose-moi trois réponses courtes à ce mail.",
    does: "Suggère des réponses que tu choisis ; aucune n'est envoyée.",
    changes: false,
  },
  {
    filter: "missions",
    say: "J'ai postulé chez Qonto pour la mission DevOps, TJM 650.",
    does: "Enregistre la candidature dans ton pipeline de missions.",
    changes: true,
  },
  {
    filter: "missions",
    say: "J'ai un entretien chez Mirakl jeudi à 14 h.",
    does: "Passe la mission en entretien ; la fiche de préparation et les cartes de révision suivent.",
    changes: true,
  },
  {
    filter: "missions",
    say: "La mission chez Alan est terminée, ils ont choisi un autre profil.",
    does: "Clôt la mission dans ton pipeline ; elle sort des relances.",
    changes: true,
  },
  {
    filter: "jour",
    say: "Qu'est-ce que j'ai aujourd'hui, et qu'est-ce qui peut attendre ?",
    does: "Combine agenda, tâches et suivis en un point rapide.",
    changes: false,
  },
  {
    filter: "jour",
    say: "Qu'est-ce que l'intake a trouvé à son dernier passage ?",
    does: "Résume le dernier passage : mails lus, offres extraites, erreurs éventuelles.",
    changes: false,
  },
];

const FILTERS: { value: PhraseFilter | "all"; label: string }[] = [
  { value: "all", label: "Tout" },
  { value: "mail", label: "Mails" },
  { value: "missions", label: "Missions" },
  { value: "jour", label: "Ma journée" },
];

const RHYTHM = [
  {
    when: "Toutes les 30 min",
    what: "Intake",
    detail:
      "Lit Gmail et l'agenda, extrait les offres des alertes Malt, Collective, Free-Work, propose des relances et des suivis.",
  },
  {
    when: "Chaque matin",
    what: "Brief",
    detail:
      "Ce qui compte aujourd'hui, pourquoi, ce qui peut attendre, ton agenda, et les offres notées 75 ou plus.",
  },
  {
    when: "J-3 avant un entretien",
    what: "Prépa + révision",
    detail:
      "Fiche de préparation et cartes de révision liées à l'offre, en boîtes Leitner 1 à 5.",
  },
  {
    when: "Chaque lundi",
    what: "Point carrière",
    detail:
      "Bilan de la semaine (heure de Paris) : candidatures, entretiens, TJM des offres vues.",
  },
];

const SETUP = [
  {
    title: "Ouvrir Duet.app",
    detail: (
      <>
        Elle lance Postgres, le serveur et l'app web sur localhost:3010. Ou, en
        terminal : <code>OPENDUET_COCKPIT=1 bun run dev</code> depuis{" "}
        <code>openbot/</code>.
      </>
    ),
  },
  {
    title: "Connecter Gmail et Google Agenda",
    detail:
      "Admin → Plugins → Gmail and Google Calendar → Connect. En mode test, Google coupe l'accès tous les 7 jours : reclique Connect chaque semaine.",
  },
  {
    title: "Activer les alertes emploi",
    detail:
      "Sur Malt, Collective et Free-Work. Duet lit les mails d'alerte ; il ne scrape aucun site et ne postule jamais tout seul.",
  },
  {
    title: "Vérifier ton profil et ton CV maître",
    detail: (
      <>
        <code>~/.config/openduet/profile.md</code> (TJM ≥ 500 €/j, remote ou
        hybride IDF) et <code>cv-master.json</code>. Les offres et le CV en
        dépendent.
      </>
    ),
  },
];

const SCREENS = [
  {
    where: "/tasks",
    name: "Tasks · Up next",
    detail:
      "Ce que Duet a ajouté pour toi, avec le lien vers le mail d'origine. Lance une tâche ou garde-la pour plus tard.",
  },
  {
    where: "/inbox",
    name: "Inbox",
    detail: "Le brief du matin et les suivis proposés : accepte, reporte ou écarte.",
  },
  {
    where: "/approvals",
    name: "Approvals",
    detail: "Toute action qui change quelque chose passe par ici avant d'être faite.",
  },
  {
    where: "App iPhone",
    name: "Missions",
    detail:
      "Le pipeline : candidature, entretien, offre. Relances proposées quand une mission se tait.",
  },
  {
    where: "App iPhone",
    name: "Offres · CV · Quiz",
    detail:
      "Offres notées sur 100 (colle une offre pour la noter), CV PDF taillé pour l'offre avec brouillon Gmail, cartes de révision avant l'entretien.",
  },
  {
    where: "/cockpit",
    name: "Cockpit",
    detail: "Tes projets de code : état git, usage Claude, CI, machine, qualité et rappels.",
  },
];

const NEVER = [
  {
    title: "Il n'envoie pas de mail",
    detail:
      "Il crée des brouillons Gmail. Tu relis, tu envoies. L'envoi direct n'est pas accordé au bot.",
  },
  {
    title: "Il n'écrit pas ton CV",
    detail:
      "Il choisit des lignes de ton CV maître pour chaque offre. Le seul texte qu'il rédige est le message d'accompagnement.",
  },
  {
    title: "Il ne te montre pas tout",
    detail:
      "Salariat, moins de 500 €/j ou hors IDF sans remote : filtré par le code, avant même le modèle.",
  },
  {
    title: "Un mail reste une donnée",
    detail:
      "Le texte d'un mail ou d'une offre n'est jamais pris comme une instruction, même s'il en contient.",
  },
];

const TROUBLE: { title: string; detail: string; command?: string }[] = [
  {
    title:
      "« Access blocked: Duet has not completed the Google verification process »",
    detail:
      "Ton adresse n'est pas dans les utilisateurs test. Google Cloud → projet duet → Google Auth Platform → Audience → Test users → Add users → Save.",
  },
  {
    title: "Gmail ne répond plus après une semaine",
    detail:
      "Normal en mode test : le jeton expire au bout de 7 jours. Admin → Plugins → Gmail and Google Calendar → Connect.",
  },
  {
    title: "Aucune offre ni aucun mail n'arrive",
    detail:
      "L'intake tourne 30 s après le démarrage puis toutes les 30 min. Vérifie que le serveur tourne et que Docker Desktop est ouvert (Postgres).",
    command: "docker start openduet-postgres-1",
  },
  {
    title: "Des lignes « egress-policy-push-failed » dans le terminal",
    detail:
      "Elles concernent l'ordinateur partagé du bot (navigateur, port 4100), éteint chez toi. Gmail et l'agenda passent par l'API Google : tu peux ignorer ces lignes.",
  },
];

/** The Bot the phrases go to: the one named Duet, else whoever the app sends to by default. */
export function guideRecipient(
  agents: readonly AgentProfile[] | undefined,
): AgentProfile | undefined {
  return (
    agents?.find((agent) => agent.name.trim().toLowerCase() === "duet") ??
    defaultAgentProfile(agents)
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-1 px-4 py-3">{children}</div>;
}

function Rows<T>({
  items,
  render,
}: {
  items: readonly T[];
  render: (item: T) => React.ReactNode;
}) {
  return (
    <PageRows>
      {items.map((item, index) => (
        <div key={index}>
          {index ? <Separator /> : null}
          {render(item)}
        </div>
      ))}
    </PageRows>
  );
}

/** Phrases to say to Duet; each opens a new conversation with the phrase already in the composer. */
export function PhraseLibrary({ agentId }: { agentId?: string }) {
  const [filter, setFilter] = useState<PhraseFilter | "all">("all");
  const shown = PHRASES.filter(
    (phrase) => filter === "all" || phrase.filter === filter,
  );
  return (
    <>
      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Filtrer les phrases">
        {FILTERS.map((entry) => (
          <Button
            aria-pressed={filter === entry.value}
            key={entry.value}
            onClick={() => setFilter(entry.value)}
            size="sm"
            variant={filter === entry.value ? "default" : "outline"}
          >
            {entry.label}
          </Button>
        ))}
      </div>
      <Rows
        items={shown}
        render={(phrase) => (
          <Row>
            <p className="type-body border-l-2 border-primary pl-3 text-pretty">
              {phrase.say}
            </p>
            <p className="type-sub text-muted-foreground text-pretty">
              {phrase.does}
            </p>
            <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
              <Chip tone={phrase.changes ? "warn" : "good"}>
                {phrase.changes ? "prépare · tu valides" : "lecture seule"}
              </Chip>
              <Button
                render={
                  <Link
                    search={{ ...(agentId ? { agent: agentId } : {}), text: phrase.say }}
                    to="/channel/new"
                  />
                }
                size="sm"
                variant="outline"
              >
                Écrire à Duet
              </Button>
            </div>
          </Row>
        )}
      />
    </>
  );
}

export function GuideContent({ agentId }: { agentId?: string }) {
  return (
    <>
      <p className="type-sub mt-4 max-w-prose text-pretty text-muted-foreground">
        Duet lit tes mails et ton agenda, suit tes missions et les offres à
        500 €/j et plus, prépare tes entretiens et tes candidatures. Rien ne part
        sans toi : il prépare, tu valides.
      </p>

      <PageSection
        title="Le rythme"
        description="Ce qui tourne sans toi."
      >
        <ol className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {RHYTHM.map((beat) => (
            <li
              className="rounded-lg border border-border bg-card p-4 dark:border-transparent"
              key={beat.what}
            >
              <p className="type-caption font-medium text-primary tabular-nums">
                {beat.when}
              </p>
              <p className="type-body mt-1 font-medium">{beat.what}</p>
              <p className="type-sub mt-1 text-muted-foreground text-pretty">
                {beat.detail}
              </p>
            </li>
          ))}
        </ol>
      </PageSection>

      <PageSection title="Démarrer" description="Une seule fois.">
        <Rows
          items={SETUP.map((step, index) => ({ ...step, index }))}
          render={(step) => (
            <Row>
              <p className="type-body font-medium">
                <span className="text-muted-foreground tabular-nums">
                  {step.index + 1}.
                </span>{" "}
                {step.title}
              </p>
              <p className="type-sub text-muted-foreground text-pretty">
                {step.detail}
              </p>
            </Row>
          )}
        />
      </PageSection>

      <PageSection
        title="Parler à Duet"
        description="Écris à Duet comme à un assistant, en français, en anglais ou les deux. « Écrire à Duet » ouvre une conversation avec la phrase prête : adapte-la, puis envoie. Les offres, le CV adapté et le quiz se gèrent dans l'app iPhone, pas dans le chat."
      >
        <PhraseLibrary agentId={agentId} />
      </PageSection>

      <PageSection title="Les écrans">
        <Rows
          items={SCREENS}
          render={(screen) => (
            <Row>
              <p className="type-body font-medium">
                {screen.name}{" "}
                <span className="type-caption font-mono text-muted-foreground">
                  {screen.where}
                </span>
              </p>
              <p className="type-sub text-muted-foreground text-pretty">
                {screen.detail}
              </p>
            </Row>
          )}
        />
      </PageSection>

      <PageSection title="Ce que Duet ne fait jamais">
        <Rows
          items={NEVER}
          render={(rule) => (
            <Row>
              <p className="type-body font-medium">{rule.title}</p>
              <p className="type-sub text-muted-foreground text-pretty">
                {rule.detail}
              </p>
            </Row>
          )}
        />
      </PageSection>

      <PageSection title="Dépannage">
        <Rows
          items={TROUBLE}
          render={(item) => (
            <details className="group px-4 py-3">
              <summary className="type-body cursor-pointer font-medium">
                {item.title}
              </summary>
              <p className="type-sub mt-2 text-muted-foreground text-pretty">
                {item.detail}
              </p>
              {item.command ? (
                <pre className="type-caption mt-2 overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono">
                  {item.command}
                </pre>
              ) : null}
            </details>
          )}
        />
      </PageSection>
    </>
  );
}
