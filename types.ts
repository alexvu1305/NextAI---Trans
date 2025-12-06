
export enum BlockType {
  HEADING = 'heading',
  PARAGRAPH = 'paragraph',
  LIST_ITEM = 'list_item',
  TABLE_CELL = 'table_cell',
  IMAGE = 'image',
  CAPTION = 'caption',
  MATH_FORMULA = 'math_formula',
  OTHER = 'other'
}

export interface BoundingBox {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

export interface TableMetadata {
  table_id: string;
  row: number;
  col: number;
  row_span: number;
  col_span: number;
}

export interface MathMetadata {
  latex: string | null;
}

export interface ListMetadata {
  level: number;
  ordered: boolean;
  marker: string | null;
}

export interface DocumentBlock {
  id: string;
  type: BlockType;
  box_2d: number[]; // [ymin, xmin, ymax, xmax] - normalized 0-1000
  source_text: string;
  translated_text?: string;
  container_id?: string;
  
  // Specialized metadata
  table_metadata?: TableMetadata;
  math_metadata?: MathMetadata;
  list_metadata?: ListMetadata;
}

export enum PageStatus {
  IDLE = 'idle',
  ANALYZING = 'analyzing',
  ANALYZED = 'analyzed',
  TRANSLATING = 'translating',
  TRANSLATED = 'translated',
  ERROR = 'error'
}

export interface DocumentPage {
  page_number: number;
  width?: number;
  height?: number;
  status: PageStatus;
  image_data_url?: string; // The rasterized image of this specific page
  blocks: DocumentBlock[];
}

export interface DLM {
  document_id: string;
  file_type: 'pdf' | 'image';
  source_data_url: string; // The raw source file (PDF base64 or Image base64)
  page_count: number;
  pages: DocumentPage[];
}

export const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh', name: 'Chinese (Simplified)' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
];
