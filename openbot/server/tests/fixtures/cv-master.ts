import type { CvMaster } from "../../src/openduet/job-offers/cv-schema";

/** A realistic master CV: 2 experiences, a few bullets, 2 skill groups. */
export const cvMasterFixture: CvMaster = {
  header: {
    name: "Wassim Suilah",
    email: "wassim@example.test",
    phone: "+33 6 00 00 00 00",
    linkedin: "https://www.linkedin.com/in/wassim-example",
    location: "Paris, France",
  },
  titles: ["Développeur Full-Stack TypeScript", "Ingénieur logiciel Backend"],
  profiles: [
    "Développeur freelance spécialisé en TypeScript, Node.js et PostgreSQL, habitué aux produits SaaS.",
    "Ingénieur backend orienté fiabilité, observabilité et livraison continue.",
  ],
  certifications: [{ year: 2022, name: "AWS Certified Developer Associate" }],
  experiences: [
    {
      id: "acme-2023",
      role: "Développeur Full-Stack",
      company: "Acme",
      start: "2023-01",
      end: null,
      context: "Plateforme SaaS de facturation, équipe de 8 personnes.",
      bullets: [
        { id: "acme-api", text: "Conception d'une API REST en TypeScript et PostgreSQL." },
        { id: "acme-ci", text: "Mise en place de la CI/CD avec GitHub Actions et Docker." },
        { id: "acme-perf", text: "Optimisation des requêtes SQL, temps de réponse divisé par trois." },
      ],
      environment: ["TypeScript", "Node.js", "PostgreSQL", "Docker"],
    },
    {
      id: "globex-2020",
      role: "Développeur Backend",
      company: "Globex",
      start: "2020-03",
      end: "2022-12",
      bullets: [
        { id: "globex-etl", text: "Développement de pipelines de données en Python." },
        { id: "globex-k8s", text: "Déploiement des services sur Kubernetes." },
      ],
      environment: ["Python", "Kubernetes"],
    },
  ],
  skills: [
    { id: "sk-lang", group: "Langages", items: ["TypeScript", "Python", "SQL"] },
    { id: "sk-ops", group: "Outils", items: ["Docker", "Kubernetes", "GitHub Actions"] },
  ],
  languages: [
    { name: "Français", level: "Langue maternelle" },
    { name: "Anglais", level: "Courant" },
  ],
};
