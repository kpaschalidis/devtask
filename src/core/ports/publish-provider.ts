export interface PrInput {
  branch: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  labels: string[];
}

export interface Pr {
  url: string;
  number: number;
}

export interface PublishProvider {
  createPr(input: PrInput): Promise<Pr>;
  findPr(branch: string): Promise<Pr | null>;
}
