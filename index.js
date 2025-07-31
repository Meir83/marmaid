#!/usr/bin/env node

/**
 * GitHub to Mermaid MCP Server
 * Analyzes GitHub repositories and generates Mermaid diagrams
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import { parse } from 'node-html-parser';

class GitHubMermaidServer {
  constructor() {
    this.server = new Server(
      {
        name: 'github-mermaid-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'analyze_github_repo',
          description: 'Analyze a GitHub repository and generate a Mermaid diagram',
          inputSchema: {
            type: 'object',
            properties: {
              github_url: {
                type: 'string',
                description: 'GitHub repository URL (e.g., https://github.com/user/repo)',
              },
              diagram_type: {
                type: 'string',
                enum: ['architecture', 'component', 'flowchart', 'dependency'],
                description: 'Type of Mermaid diagram to generate',
                default: 'architecture',
              },
              include_mermaid_live: {
                type: 'boolean',
                description: 'Include mermaid.live URL for visualization',
                default: true,
              },
            },
            required: ['github_url'],
          },
        },
        {
          name: 'generate_mermaid_live_url',
          description: 'Generate a mermaid.live URL from Mermaid code',
          inputSchema: {
            type: 'object',
            properties: {
              mermaid_code: {
                type: 'string',
                description: 'Mermaid diagram code',
              },
            },
            required: ['mermaid_code'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      switch (request.params.name) {
        case 'analyze_github_repo':
          return this.analyzeGitHubRepo(request.params.arguments);
        case 'generate_mermaid_live_url':
          return this.generateMermaidLiveUrl(request.params.arguments);
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  async analyzeGitHubRepo(args) {
    try {
      const { github_url, diagram_type = 'architecture', include_mermaid_live = true } = args;
      
      // Validate GitHub URL
      const urlMatch = github_url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
      if (!urlMatch) {
        throw new Error('Invalid GitHub URL format');
      }

      const [, owner, repo] = urlMatch;
      const cleanRepo = repo.replace(/\.git$/, '');

      // Fetch repository information
      const repoInfo = await this.fetchGitHubRepo(owner, cleanRepo);
      const packageJson = await this.fetchPackageJson(owner, cleanRepo);
      const fileStructure = await this.fetchFileStructure(owner, cleanRepo);

      // Generate Mermaid diagram based on type
      let mermaidCode;
      switch (diagram_type) {
        case 'architecture':
          mermaidCode = this.generateArchitectureDiagram(repoInfo, packageJson, fileStructure);
          break;
        case 'component':
          mermaidCode = this.generateComponentDiagram(fileStructure, packageJson);
          break;
        case 'flowchart':
          mermaidCode = this.generateFlowchartDiagram(repoInfo, fileStructure);
          break;
        case 'dependency':
          mermaidCode = this.generateDependencyDiagram(packageJson);
          break;
        default:
          mermaidCode = this.generateArchitectureDiagram(repoInfo, packageJson, fileStructure);
      }

      const result = {
        repository: {
          name: repoInfo.name,
          description: repoInfo.description,
          language: repoInfo.language,
          stars: repoInfo.stargazers_count,
          forks: repoInfo.forks_count,
        },
        mermaid_code: mermaidCode,
        diagram_type,
      };

      if (include_mermaid_live) {
        result.mermaid_live_url = this.createMermaidLiveUrl(mermaidCode);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to analyze repository: ${error.message}`
      );
    }
  }

  async generateMermaidLiveUrl(args) {
    try {
      const { mermaid_code } = args;
      const url = this.createMermaidLiveUrl(mermaid_code);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              mermaid_live_url: url,
              encoded_diagram: this.encodeMermaidForUrl(mermaid_code),
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to generate mermaid.live URL: ${error.message}`
      );
    }
  }

  async fetchGitHubRepo(owner, repo) {
    try {
      const response = await axios.get(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'GitHub-Mermaid-MCP-Server',
        },
      });
      return response.data;
    } catch (error) {
      if (error.response?.status === 404) {
        throw new Error('Repository not found or is private');
      }
      throw new Error(`GitHub API error: ${error.message}`);
    }
  }

  async fetchPackageJson(owner, repo) {
    try {
      const response = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/contents/package.json`,
        {
          headers: {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'GitHub-Mermaid-MCP-Server',
          },
        }
      );
      
      const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
      return JSON.parse(content);
    } catch (error) {
      return null; // Not all repos have package.json
    }
  }

  async fetchFileStructure(owner, repo) {
    try {
      const response = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`,
        {
          headers: {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'GitHub-Mermaid-MCP-Server',
          },
        }
      );
      return response.data.tree;
    } catch (error) {
      return [];
    }
  }

  generateArchitectureDiagram(repoInfo, packageJson, fileStructure) {
    const language = repoInfo.language?.toLowerCase() || 'unknown';
    const hasPackageJson = !!packageJson;
    
    // Analyze file structure
    const folders = this.analyzeFolders(fileStructure);
    const techStack = this.analyzeTechStack(packageJson, fileStructure, language);

    let diagram = `graph TB
    %% ${repoInfo.name} - System Architecture
    subgraph "Repository: ${repoInfo.name}"
        Repo[📁 ${repoInfo.name}<br/>${repoInfo.description || 'No description'}]
    end
    
`;

    // Add main folders
    if (folders.length > 0) {
      diagram += `    subgraph "Project Structure"
`;
      folders.forEach(folder => {
        const icon = this.getFolderIcon(folder);
        diagram += `        ${this.sanitizeId(folder)}[${icon} ${folder}]
`;
      });
      diagram += `    end
    
`;
    }

    // Add tech stack
    if (techStack.frontend.length > 0 || techStack.backend.length > 0) {
      diagram += `    subgraph "Technology Stack"
`;
      
      if (techStack.frontend.length > 0) {
        diagram += `        subgraph "Frontend"
`;
        techStack.frontend.forEach(tech => {
          diagram += `            ${this.sanitizeId(tech)}[⚛️ ${tech}]
`;
        });
        diagram += `        end
`;
      }

      if (techStack.backend.length > 0) {
        diagram += `        subgraph "Backend"
`;
        techStack.backend.forEach(tech => {
          diagram += `            ${this.sanitizeId(tech)}[🔧 ${tech}]
`;
        });
        diagram += `        end
`;
      }
      diagram += `    end
    
`;
    }

    // Add connections
    diagram += `    %% Connections
    Repo --> ProjectStructure
`;
    if (folders.includes('src')) {
      diagram += `    ProjectStructure --> src
`;
    }
    if (folders.includes('components')) {
      diagram += `    src --> components
`;
    }

    // Add styling
    diagram += `
    %% Styling
    classDef repo fill:#e1f5fe
    classDef folder fill:#f3e5f5
    classDef tech fill:#e8f5e8
    
    class Repo repo
    class ${folders.map(f => this.sanitizeId(f)).join(',')} folder
`;

    return diagram;
  }

  generateComponentDiagram(fileStructure, packageJson) {
    const components = this.findComponents(fileStructure);
    
    let diagram = `graph TD
    %% Component Diagram
`;

    if (components.length > 0) {
      diagram += `    subgraph "Components"
`;
      components.forEach(comp => {
        const cleanName = comp.replace(/\.(jsx?|tsx?|vue)$/, '');
        diagram += `        ${this.sanitizeId(cleanName)}[🧩 ${cleanName}]
`;
      });
      diagram += `    end
`;
    }

    return diagram;
  }

  generateFlowchartDiagram(repoInfo, fileStructure) {
    return `flowchart TD
    Start([🚀 ${repoInfo.name}]) --> Development
    Development --> Build[🔨 Build Process]
    Build --> Test[🧪 Testing]
    Test --> Deploy[🚀 Deployment]
    Deploy --> End([✅ Production])
    
    classDef startEnd fill:#e8f5e8
    classDef process fill:#fff3e0
    
    class Start,End startEnd
    class Development,Build,Test,Deploy process
`;
  }

  generateDependencyDiagram(packageJson) {
    if (!packageJson || !packageJson.dependencies) {
      return `graph LR
    App[📦 Application] --> NoDeps[No dependencies found]
`;
    }

    const deps = Object.keys(packageJson.dependencies).slice(0, 10); // Limit to 10 for readability
    
    let diagram = `graph LR
    App[📦 ${packageJson.name || 'Application'}]
    
`;

    deps.forEach(dep => {
      diagram += `    App --> ${this.sanitizeId(dep)}[📚 ${dep}]
`;
    });

    return diagram;
  }

  analyzeFolders(fileStructure) {
    const folders = new Set();
    fileStructure.forEach(file => {
      if (file.type === 'tree') {
        folders.add(file.path);
      } else {
        const pathParts = file.path.split('/');
        if (pathParts.length > 1) {
          folders.add(pathParts[0]);
        }
      }
    });
    return Array.from(folders).slice(0, 15); // Limit for readability
  }

  analyzeTechStack(packageJson, fileStructure, language) {
    const frontend = [];
    const backend = [];

    if (packageJson && packageJson.dependencies) {
      const deps = Object.keys(packageJson.dependencies);
      
      // Frontend frameworks
      if (deps.includes('react')) frontend.push('React');
      if (deps.includes('vue')) frontend.push('Vue.js');
      if (deps.includes('angular')) frontend.push('Angular');
      if (deps.includes('svelte')) frontend.push('Svelte');
      if (deps.includes('next')) frontend.push('Next.js');
      if (deps.includes('nuxt')) frontend.push('Nuxt.js');
      
      // Backend frameworks
      if (deps.includes('express')) backend.push('Express.js');
      if (deps.includes('fastify')) backend.push('Fastify');
      if (deps.includes('koa')) backend.push('Koa.js');
      if (deps.includes('nestjs')) backend.push('NestJS');
    }

    // Add language
    if (language && !frontend.includes(language) && !backend.includes(language)) {
      if (['javascript', 'typescript'].includes(language)) {
        frontend.push(language.charAt(0).toUpperCase() + language.slice(1));
      } else {
        backend.push(language.charAt(0).toUpperCase() + language.slice(1));
      }
    }

    return { frontend, backend };
  }

  findComponents(fileStructure) {
    return fileStructure
      .filter(file => {
        const path = file.path.toLowerCase();
        return (path.includes('component') || path.includes('src/')) &&
               /\.(jsx?|tsx?|vue)$/.test(path);
      })
      .map(file => file.path.split('/').pop())
      .slice(0, 10); // Limit for readability
  }

  getFolderIcon(folderName) {
    const icons = {
      'src': '💻',
      'components': '🧩',
      'pages': '📄',
      'styles': '🎨',
      'assets': '🖼️',
      'public': '🌐',
      'tests': '🧪',
      'docs': '📚',
      'config': '⚙️',
      'utils': '🔧',
      'hooks': '🪝',
      'services': '🔌',
      'api': '🌐',
      'data': '💾',
      'models': '🗂️',
    };
    return icons[folderName.toLowerCase()] || '📁';
  }

  sanitizeId(str) {
    return str.replace(/[^a-zA-Z0-9]/g, '_');
  }

  encodeMermaidForUrl(mermaidCode) {
    // Encode for URL - mermaid.live uses base64 encoding
    return Buffer.from(mermaidCode).toString('base64');
  }

  createMermaidLiveUrl(mermaidCode) {
    const encoded = this.encodeMermaidForUrl(mermaidCode);
    return `https://mermaid.live/edit#base64:${encoded}`;
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('GitHub Mermaid MCP server running on stdio');
  }
}

const server = new GitHubMermaidServer();
server.run().catch(console.error);