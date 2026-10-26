<?php

namespace Tests\Feature;

use App\Mail\AccountMail;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

/**
 * Email link buttons point at the frontend; a localhost link is dead on the
 * recipient's phone, so buttons appear only once VMS has a real address.
 */
class AccountMailLinksTest extends TestCase
{
    use RefreshDatabase;

    #[Test]
    public function emails_have_no_link_buttons_while_the_frontend_is_local(): void
    {
        config(['app.frontend_url' => 'http://localhost:5173']);

        $html = (new AccountMail(User::factory()->create(), 'Active', 'activated'))->render();

        $this->assertStringNotContainsString('Sign in to VMS', $html);
        $this->assertStringNotContainsString('localhost:5173', $html);
    }

    #[Test]
    public function emails_show_link_buttons_once_deployed(): void
    {
        config(['app.frontend_url' => 'https://vms.example.ph']);

        $html = (new AccountMail(User::factory()->create(), 'Active', 'activated'))->render();

        $this->assertStringContainsString('Sign in to VMS', $html);
        $this->assertStringContainsString('https://vms.example.ph/login', $html);
    }
}
