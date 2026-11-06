import { expect, test } from "bun:test";
import { companyKey, contactOf, missionSignal } from "../src/openduet/missions/mail-signal";

/** What a mail says about a mission. Platform job alerts say nothing, whatever words they use. */

function mail(subject: string, snippet = "", from = "Claire <claire@acme.fr>") {
  return { from, subject, snippet };
}

test("rejection beats everything else in the same mail", () => {
  expect(
    missionSignal(mail("Votre candidature", "Nous avons le regret de vous informer que nous ne donnons pas suite. Une offre de mission suivra peut-être.")),
  ).toBe("rejection");
  expect(missionSignal(mail("Re: Mission", "Malheureusement, votre profil n'a pas été retenu"))).toBe("rejection");
});

test("an offer is a proposal for a mission or a contract", () => {
  expect(missionSignal(mail("Proposition de mission", "Nous souhaitons vous proposer un contrat de 6 mois"))).toBe("offer");
});

test("an invitation to talk is an invite", () => {
  expect(missionSignal(mail("Entretien jeudi", "Seriez-vous disponible jeudi à 14h ?"))).toBe("invite");
  expect(missionSignal(mail("Invitation", "Lien visio pour notre échange"))).toBe("invite");
});

test("any other human mail is a reply", () => {
  expect(missionSignal(mail("Re: Votre candidature", "Merci pour votre message, je reviens vers vous."))).toBe("reply");
});

test("a Free-Work job alert is not an offer", () => {
  const alert = {
    from: "Free-Work <alertes@free-work.com>",
    subject: "Nouvelles offres d'emploi pour vous : 12 offres de mission Développeur",
    snippet: "Découvrez les offres de mission qui correspondent à votre alerte",
  };
  expect(missionSignal(alert)).toBeNull();
  expect(
    missionSignal({ from: "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>", subject: "Nouvelle offre : Lead dev chez Acme", snippet: "" }),
  ).toBeNull();
});

test("companyKey ignores case, accents, punctuation and legal suffixes", () => {
  expect(companyKey("Société Générale")).toBe("societegenerale");
  expect(companyKey("ACME S.A.S.")).toBe("acme");
  expect(companyKey("  Acme  ")).toBe("acme");
  expect(companyKey("")).toBe("");
});

test("contactOf is the lowercase address of a person, null for platforms and no-reply senders", () => {
  expect(contactOf("Claire <Claire@Acme.fr>")).toBe("claire@acme.fr");
  expect(contactOf("claire@acme.fr")).toBe("claire@acme.fr");
  expect(contactOf("Malt <hello@malt.fr>")).toBeNull();
  expect(contactOf("Jobs <jobs@mail.linkedin.com>")).toBeNull();
  expect(contactOf("Acme <no-reply@acme.fr>")).toBeNull();
  expect(contactOf("garbage")).toBeNull();
});
