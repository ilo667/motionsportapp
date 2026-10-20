import { Controller, Get, Post, Body, HttpCode } from '@nestjs/common';
import { DemoService, ScenarioName } from './demo.service';

@Controller('demo')
export class DemoController {
  constructor(private readonly demoService: DemoService) {}

  @Get('info')
  getInfo() {
    return this.demoService.getInfo();
  }

  @Post('scenario')
  @HttpCode(200)
  setScenario(@Body() body: { scenario: ScenarioName }) {
    return this.demoService.setScenario(body.scenario);
  }

  @Post('reset')
  @HttpCode(200)
  reset() {
    return this.demoService.reset();
  }
}