import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateSlotDto } from './update-slot.dto';

const errorsFor = (body: object) => validate(plainToInstance(UpdateSlotDto, body));

describe('UpdateSlotDto — PATCH /admin/slots/:id', () => {
  it('takes CANCELLED', async () => {
    expect(await errorsFor({ status: 'CANCELLED' })).toHaveLength(0);
  });

  it('never ACTIVE: a cancelled training is not brought back', async () => {
    expect(await errorsFor({ status: 'ACTIVE' })).not.toHaveLength(0);
    expect(await errorsFor({})).not.toHaveLength(0);
  });
});
