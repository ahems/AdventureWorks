import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { graphqlClient } from '@/lib/graphql-client';
import { gql } from 'graphql-request';
import { toast } from './use-toast';

export interface ProfileData {
  BusinessEntityID: number;
  Title?: string | null;
  FirstName: string;
  MiddleName?: string | null;
  LastName: string;
  Suffix?: string | null;
  EmailAddress: string;
  EmailAddressID?: number;
  PhoneNumber?: string | null;
  PhoneNumberTypeID?: number | null;
}

const GET_PROFILE = gql`
  query GetProfile($businessEntityId: Int!) {
    person_by_pk(BusinessEntityID: $businessEntityId) {
      BusinessEntityID
      Title
      FirstName
      MiddleName
      LastName
      Suffix
    }
    emailAddresses(filter: { BusinessEntityID: { eq: $businessEntityId } }) {
      items {
        EmailAddressID
        EmailAddress
      }
    }
    personPhones(filter: { BusinessEntityID: { eq: $businessEntityId } }) {
      items {
        PhoneNumber
        PhoneNumberTypeID
      }
    }
  }
`;

const UPDATE_PERSON = gql`
  mutation UpdatePerson(
    $businessEntityId: Int!
    $title: String
    $firstName: String!
    $middleName: String
    $lastName: String!
    $suffix: String
  ) {
    updatePerson(
      BusinessEntityID: $businessEntityId
      item: {
        Title: $title
        FirstName: $firstName
        MiddleName: $middleName
        LastName: $lastName
        Suffix: $suffix
      }
    ) {
      BusinessEntityID
      Title
      FirstName
      MiddleName
      LastName
      Suffix
    }
  }
`;

const UPDATE_EMAIL_ADDRESS = gql`
  mutation UpdateEmailAddress(
    $businessEntityId: Int!
    $emailAddressId: Int!
    $emailAddress: String!
  ) {
    updateEmailAddress(
      BusinessEntityID: $businessEntityId
      EmailAddressID: $emailAddressId
      item: { EmailAddress: $emailAddress }
    ) {
      EmailAddressID
      EmailAddress
    }
  }
`;

export const useProfile = (businessEntityId: number) => {
  return useQuery<ProfileData>({
    queryKey: ['profile', businessEntityId],
    queryFn: async () => {
      const data: any = await graphqlClient.request(GET_PROFILE, { businessEntityId });
      
      const person = data.person_by_pk;
      const email = data.emailAddresses.items[0];
      const phone = data.personPhones.items[0];
      
      return {
        BusinessEntityID: person.BusinessEntityID,
        Title: person.Title,
        FirstName: person.FirstName,
        MiddleName: person.MiddleName,
        LastName: person.LastName,
        Suffix: person.Suffix,
        EmailAddress: email?.EmailAddress || '',
        EmailAddressID: email?.EmailAddressID,
        PhoneNumber: phone?.PhoneNumber,
        PhoneNumberTypeID: phone?.PhoneNumberTypeID,
      };
    },
    enabled: !!businessEntityId,
  });
};

export const useUpdateProfile = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (profile: ProfileData) => {
      // Get REST API URL and ensure no trailing slash
      let restApiUrl = window.APP_CONFIG?.API_URL?.replace('/graphql', '/api') || 
                       import.meta.env.VITE_API_URL?.replace('/graphql', '/api') || 
                       'http://localhost:5000/api';
      // Remove trailing slash if present
      restApiUrl = restApiUrl.replace(/\/$/, '');

      // Update Person
      await graphqlClient.request(UPDATE_PERSON, {
        businessEntityId: profile.BusinessEntityID,
        title: profile.Title || null,
        firstName: profile.FirstName,
        middleName: profile.MiddleName || null,
        lastName: profile.LastName,
        suffix: profile.Suffix || null,
      });

      // Update Email if changed
      if (profile.EmailAddressID) {
        await graphqlClient.request(UPDATE_EMAIL_ADDRESS, {
          businessEntityId: profile.BusinessEntityID,
          emailAddressId: profile.EmailAddressID,
          emailAddress: profile.EmailAddress,
        });
      }

      // Update or create phone number
      if (profile.PhoneNumber) {
        const phoneNumberTypeId = profile.PhoneNumberTypeID || 1; // Default to Cell
        
        console.log('[useProfile] Updating phone number:', {
          phoneNumber: profile.PhoneNumber,
          phoneNumberTypeId,
          businessEntityId: profile.BusinessEntityID,
          restApiUrl
        });
        
        // Check if phone exists
        const checkUrl = `${restApiUrl}/PersonPhone?$filter=BusinessEntityID eq ${profile.BusinessEntityID}`;
        console.log('[useProfile] Checking for existing phone:', checkUrl);
        const existingPhones = await fetch(checkUrl).then(r => r.json());

        console.log('[useProfile] Existing phones:', existingPhones);
        
        if (existingPhones.value && existingPhones.value.length > 0) {
          // PersonPhone has a composite primary key (BusinessEntityID, PhoneNumber, PhoneNumberTypeID)
          // Since PhoneNumber is part of the primary key, we can't update it directly
          // Instead, delete the old record and create a new one
          
          for (const existingPhone of existingPhones.value) {
            const deleteUrl = `${restApiUrl}/PersonPhone/BusinessEntityID/${profile.BusinessEntityID}/PhoneNumber/${encodeURIComponent(existingPhone.PhoneNumber)}/PhoneNumberTypeID/${existingPhone.PhoneNumberTypeID}`;
            console.log('[useProfile] Deleting old phone at:', deleteUrl);
            
            const deleteResponse = await fetch(deleteUrl, {
              method: 'DELETE',
            });
            
            if (!deleteResponse.ok) {
              const errorText = await deleteResponse.text();
              console.error('[useProfile] Phone deletion failed:', deleteResponse.status, errorText);
              throw new Error(`Phone deletion failed: ${deleteResponse.status} ${errorText}`);
            }
            console.log('[useProfile] Old phone deleted successfully');
          }
          
          // Now create the new phone record
          const createUrl = `${restApiUrl}/PersonPhone`;
          const createPayload = {
            BusinessEntityID: profile.BusinessEntityID,
            PhoneNumber: profile.PhoneNumber,
            PhoneNumberTypeID: phoneNumberTypeId,
          };
          console.log('[useProfile] Creating new phone at:', createUrl);
          console.log('[useProfile] Create payload:', createPayload);
          
          const createResponse = await fetch(createUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(createPayload),
          });
          
          if (!createResponse.ok) {
            const errorText = await createResponse.text();
            console.error('[useProfile] Phone creation failed:', createResponse.status, errorText);
            throw new Error(`Phone creation failed: ${createResponse.status} ${errorText}`);
          }
          console.log('[useProfile] New phone created successfully');
        } else {
          // Create new phone
          const createUrl = `${restApiUrl}/PersonPhone`;
          const createPayload = {
            BusinessEntityID: profile.BusinessEntityID,
            PhoneNumber: profile.PhoneNumber,
            PhoneNumberTypeID: phoneNumberTypeId,
          };
          console.log('[useProfile] Creating phone at:', createUrl);
          console.log('[useProfile] Create payload:', createPayload);
          
          const response = await fetch(createUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(createPayload),
          });
          
          if (!response.ok) {
            const errorText = await response.text();
            console.error('[useProfile] Phone creation failed:', response.status, errorText);
            throw new Error(`Phone creation failed: ${response.status} ${errorText}`);
          }
          console.log('[useProfile] Phone created successfully');
        }
      }

      return profile;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['profile', data.BusinessEntityID] });
      toast({
        title: 'Profile Updated',
        description: 'Your profile has been updated successfully.',
      });
    },
    onError: (error: any) => {
      toast({
        title: 'Update Failed',
        description: error.message || 'Failed to update profile. Please try again.',
        variant: 'destructive',
      });
    },
  });
};
