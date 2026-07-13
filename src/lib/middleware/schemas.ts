import { z } from 'zod';

export const githubWebhookSchema = z.object({
  action: z.string().optional(),
  sender: z.object({
    id: z.number().or(z.string()).transform((val) => val.toString()),
  }).optional(),
  installation: z.object({
    id: z.number().or(z.string()).transform((val) => Number(val)),
  }).optional(),
  repository: z.object({
    id: z.number().or(z.string()).transform((val) => val.toString()),
    name: z.string(),
    full_name: z.string(),
    owner: z.object({
      login: z.string(),
    }),
  }).optional(),
  pull_request: z.object({
    id: z.number().or(z.string()).transform((val) => val.toString()),
    number: z.number(),
    title: z.string(),
    state: z.string(),
    head: z.object({
      sha: z.string(),
    }),
  }).optional(),
  repositories: z.array(
    z.object({
      id: z.number().or(z.string()).transform((val) => val.toString()),
      name: z.string(),
      full_name: z.string(),
    })
  ).optional(),
  repositories_added: z.array(
    z.object({
      id: z.number().or(z.string()).transform((val) => val.toString()),
      name: z.string(),
      full_name: z.string(),
    })
  ).optional(),
});
