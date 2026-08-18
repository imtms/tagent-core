interface WorkspaceSkillAuthorityToken {
  workspaceId: string;
  generation: number;
}

export class WorkspaceSkillAuthority {
  private workspaceId = "";
  private generation = 0;

  enterWorkspace(workspaceId: string): WorkspaceSkillAuthorityToken {
    this.workspaceId = workspaceId;
    this.generation += 1;
    return this.capture();
  }

  capture(): WorkspaceSkillAuthorityToken {
    return { workspaceId: this.workspaceId, generation: this.generation };
  }

  isCurrent(token: WorkspaceSkillAuthorityToken): boolean {
    return token.workspaceId === this.workspaceId && token.generation === this.generation;
  }
}
