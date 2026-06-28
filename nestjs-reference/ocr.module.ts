import { Module } from '@nestjs/common';
import { GoogleVisionService } from './google-vision.service';
import { OcrController } from './ocr.controller';

@Module({
  controllers: [OcrController],
  providers: [GoogleVisionService],
  exports: [GoogleVisionService],
})
export class OcrModule {}
