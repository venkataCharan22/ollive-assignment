import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from "class-validator";

class MessageDto {
  @IsIn(["system", "user", "assistant"])
  role!: "system" | "user" | "assistant";

  @IsString()
  content!: string;
}

class UsageDto {
  @IsInt() @Min(0) promptTokens!: number;
  @IsInt() @Min(0) completionTokens!: number;
  @IsInt() @Min(0) totalTokens!: number;
}

export class InferenceLogDto {
  @IsString() requestId!: string;
  @IsString() conversationId!: string;
  @IsIn(["openai", "anthropic", "google", "groq", "mock"]) provider!: string;
  @IsString() model!: string;
  @IsIn(["ok", "error", "cancelled"]) status!: "ok" | "error" | "cancelled";

  @IsISO8601() startedAt!: string;
  @IsISO8601() finishedAt!: string;

  @IsInt() @Min(0) @Max(1_000 * 60 * 30) latencyMs!: number;
  @IsOptional() @IsInt() @Min(0) ttftMs?: number;
  @IsBoolean() streamed!: boolean;

  @ValidateNested() @Type(() => UsageDto) usage!: UsageDto;

  @IsString() inputPreview!: string;
  @IsString() outputPreview!: string;

  @IsArray() @ValidateNested({ each: true }) @Type(() => MessageDto) messages!: MessageDto[];
  @IsOptional() @IsString() output?: string;

  @IsOptional() @IsString() errorCode?: string;
  @IsOptional() @IsString() errorMessage?: string;
  @IsOptional() @IsObject() tags?: Record<string, string>;
  @IsString() sdkVersion!: string;
}
