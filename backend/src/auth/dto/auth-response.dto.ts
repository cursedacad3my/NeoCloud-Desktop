import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Configuration for SoundCloud API credentials
 */
export class SetCredentialsDto {
  @ApiProperty({ description: 'SoundCloud Client ID' }) 
  clientId: string;

  @ApiProperty({ description: 'SoundCloud Client Secret' }) 
  clientSecret: string;

  @ApiPropertyOptional({ description: 'OAuth Redirect URI' }) 
  redirectUri?: string;
}

/**
 * Initial login response providing the OAuth URL
 */
export class LoginResponseDto {
  @ApiProperty({ description: 'SoundCloud OAuth authorization URL' }) 
  url: string;

  @ApiProperty({ description: 'Session ID to use for subsequent requests', format: 'uuid' })
  sessionId: string;
}

/**
 * Current session state and user information
 */
export class SessionResponseDto {
  @ApiProperty() 
  authenticated: boolean;

  @ApiPropertyOptional({ format: 'uuid' }) 
  sessionId?: string;

  @ApiPropertyOptional() 
  username?: string;

  @ApiPropertyOptional() 
  soundcloudUserId?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time' }) 
  expiresAt?: Date;
}

/**
 * Response after refreshing an expired session
 */
export class RefreshResponseDto {
  @ApiProperty({ format: 'uuid' }) 
  sessionId: string;

  @ApiProperty({ type: String, format: 'date-time' }) 
  expiresAt: Date;
}

/**
 * Standard logout confirmation
 */
export class LogoutResponseDto {
  @ApiProperty() 
  success: boolean;
}