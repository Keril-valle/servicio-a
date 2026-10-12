import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { OnvoClient } from './onvo.client';

@Module({
  imports: [HttpModule],
  providers: [OnvoClient],
  exports: [OnvoClient],
})
export class OnvoModule {}
