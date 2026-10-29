import { z } from "zod";

export const createSaleSchema = z.object({
  title: z.string().min(1, "Title is required").max(255),
  totalStock: z.number().int().positive("totalStock must be greater than 0"),
  startTime: z.coerce.date().default(() => new Date()),
  endTime: z.coerce.date().optional(),
});

export type CreateSaleInput = z.infer<typeof createSaleSchema>;

export const saleParamsSchema = z.object({
  id: z.string().uuid("Invalid sale ID format"),
});

export type SaleParams = z.infer<typeof saleParamsSchema>;
