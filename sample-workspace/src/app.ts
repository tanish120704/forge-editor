/**
 * Welcome to Forge.
 * Your files, your tools, your next idea.
 */

import { palette, type Theme } from './theme';

interface Project {
  name: string;
  description: string;
  language: string;
  updatedAt: Date;
}

const projects: Project[] = [
  {
    name: 'Something worth building',
    description: 'Every great project starts with a single file.',
    language: 'TypeScript',
    updatedAt: new Date(),
  },
];

export function createWorkspace(theme: Theme = 'midnight') {
  const colors = palette[theme];

  return {
    name: 'My workspace',
    projects,
    colors,

    addProject(project: Project) {
      projects.push(project);
      return projects.length;
    },

    findProject(name: string) {
      return projects.find(project => project.name === name);
    },
  };
}

// Try it: edit this file, then press ⌘S to save.
// Press ⌘P to find a file, or ⌘⇧P for commands.
const workspace = createWorkspace();
console.log(`Ready to build in ${workspace.name}.`);
