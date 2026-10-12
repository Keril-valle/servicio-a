import { IsBoolean } from 'class-validator';

export class SimulacionDto {
  @IsBoolean()
  storeDown: boolean;
}
