import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { GoogleVisionService } from './google-vision.service';

interface ScanImageDto {
  image: string; // Base64 representation of the image
}

@Controller('api/ocr')
export class OcrController {
  constructor(private readonly visionService: GoogleVisionService) {}

  @Post('scan')
  @HttpCode(HttpStatus.OK)
  async scanImage(@Body() body: ScanImageDto) {
    if (!body.image) {
      return {
        error: 'image data is required',
        success: false,
      };
    }

    const result = await this.visionService.scanImage(body.image);
    return {
      success: true,
      ...result,
    };
  }
}
